"""
TechHealth Security Reviewer — AWS Lambda function.

Triggered by EventBridge when a new CloudFormation template is uploaded to the
CDK templates S3 bucket. Submits the template to Amazon Bedrock (Claude) for a
security review against the checks defined in the project brief, then writes a
timestamped JSON findings report to the findings S3 bucket.

This function surfaces findings for human review only. It does not block or
approve deployments — all accept/reject decisions remain with the consultant
and are logged in docs/decisions.md. (First-off Decision 6, scope boundary)

Environment variables (injected by CDK at deploy time — see pipeline-stack.ts):
    TEMPLATES_BUCKET_NAME  : S3 bucket containing synthesized CDK templates
    FINDINGS_BUCKET_NAME   : S3 bucket where findings reports are written
    BEDROCK_REGION         : AWS region for Bedrock API calls (af-south-1)
"""

import json
import logging
import os
import re
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
# Lambda captures everything written to stdout/stderr into CloudWatch Logs.
# Using the standard logging module rather than print() gives us log levels,
# which makes it easy to filter for errors in CloudWatch Insights.
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# AWS clients
# ---------------------------------------------------------------------------
# Clients are initialised outside the handler so they are reused across warm
# invocations. boto3 clients are thread-safe for reuse within the same process.
s3_client = boto3.client('s3')
bedrock_client = boto3.client(
    'bedrock-runtime',
    region_name=os.environ.get('BEDROCK_REGION', 'af-south-1'),
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
TEMPLATES_BUCKET = os.environ['TEMPLATES_BUCKET_NAME']
FINDINGS_BUCKET = os.environ['FINDINGS_BUCKET_NAME']

# Bedrock model ID. Claude 3.5 Sonnet is preferred for its reasoning quality
# on structured security analysis. Claude 3 Haiku is the fallback — it is
# faster and cheaper but produces less detailed findings.
BEDROCK_MODEL_ID = 'anthropic.claude-3-5-sonnet-20241022-v2:0'
BEDROCK_MODEL_FALLBACK_ID = 'anthropic.claude-3-haiku-20240307-v1:0'

# Maximum template size to send to Bedrock in a single call.
# CloudFormation templates for this project are well under 100 KB, but
# this guard prevents runaway costs if an unexpectedly large file lands
# in the bucket.
MAX_TEMPLATE_BYTES = 200_000  # 200 KB

# Security review prompt — the four checks are derived directly from the
# project brief's "AWS Best Practices" section and decisions.md Task 3.
# The prompt instructs Claude to reason about intent and context, not just
# pattern-match, which is the core reason Bedrock was chosen over a
# rules-based linter. (decisions.md Task 3, "Why I did it")
SECURITY_REVIEW_PROMPT = """You are an AWS infrastructure security reviewer specialising in CloudFormation templates for healthcare workloads.

Review the CloudFormation template below against the following security checks. For each check, state clearly whether it PASSES, FAILS, or is NOT APPLICABLE, followed by a brief explanation of your reasoning. Be specific — reference the resource logical IDs and property values you examined.

Security checks to evaluate:

1. RDS PUBLIC ACCESS
   Pass condition: No RDS DBInstance or DBCluster has PubliclyAccessible set to true.
   Fail condition: Any RDS resource is publicly accessible, or the property is absent on a resource that defaults to public.

2. SSH ACCESS RESTRICTION
   Pass condition: No security group allows inbound TCP port 22 from 0.0.0.0/0 or ::/0.
   Fail condition: Any security group rule permits unrestricted SSH access from the internet.

3. LEAST-PRIVILEGE IAM
   Pass condition: IAM roles and policies are scoped to specific resources (no "*" in Resource), and actions are limited to what is required.
   Fail condition: Any IAM policy uses a wildcard ("*") in both Action and Resource, or grants broad admin-level permissions without clear justification.

4. NETWORK SEGMENTATION
   Pass condition: RDS instances are placed in private subnets only (not associated with subnets that have a route to an Internet Gateway), and application resources in private subnets are not directly internet-facing.
   Fail condition: RDS or application resources are placed in public subnets, or private subnet resources have direct internet routes.

After evaluating all four checks, provide:
- OVERALL RISK: LOW, MEDIUM, or HIGH
- SUMMARY: Two to four sentences summarising the overall security posture and the most important finding.
- RECOMMENDATIONS: A numbered list of any actions the consultant should take before deploying. If all checks pass, state that no action is required.

Template to review:

{template_content}"""


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def handler(event: dict, context) -> dict:
    """
    Lambda entry point. Receives an EventBridge event wrapping an S3 Object
    Created notification, retrieves the template, calls Bedrock, and writes
    findings to the findings bucket.

    Args:
        event   : EventBridge event dict. The S3 object key is at
                  event['detail']['object']['key'].
        context : Lambda context object (used for request ID in the report).

    Returns:
        A dict with statusCode and a body summarising the outcome.
        The return value is not consumed by EventBridge but is useful for
        manual test invocations and visible in CloudWatch Logs.
    """
    logger.info('Security reviewer invoked. Event: %s', json.dumps(event))

    # -----------------------------------------------------------------------
    # Step 1 — Extract S3 object details from the EventBridge event
    # -----------------------------------------------------------------------
    # EventBridge S3 Object Created events have the structure:
    #   event['detail']['bucket']['name']
    #   event['detail']['object']['key']
    try:
        bucket_name = event['detail']['bucket']['name']
        object_key = event['detail']['object']['key']
    except KeyError as exc:
        logger.error('Malformed event — missing field: %s. Full event: %s', exc, json.dumps(event))
        return _error_response(f'Malformed event: missing {exc}')

    logger.info('Processing template: s3://%s/%s', bucket_name, object_key)

    # Confirm the event is for the expected templates bucket.
    # EventBridge filtering in the rule already handles this, but a second
    # check here ensures the function does not process unexpected objects if
    # the rule is ever widened.
    if bucket_name != TEMPLATES_BUCKET:
        logger.warning(
            'Event bucket %s does not match expected templates bucket %s. Skipping.',
            bucket_name, TEMPLATES_BUCKET,
        )
        return _error_response('Unexpected source bucket — skipping.')

    # -----------------------------------------------------------------------
    # Step 2 — Read the CloudFormation template from S3
    # -----------------------------------------------------------------------
    template_content = _read_template(bucket_name, object_key)
    if template_content is None:
        return _error_response(f'Failed to read template from s3://{bucket_name}/{object_key}')

    # -----------------------------------------------------------------------
    # Step 3 — Submit template to Bedrock for security review
    # -----------------------------------------------------------------------
    findings_text = _invoke_bedrock(template_content, object_key)
    if findings_text is None:
        return _error_response('Bedrock invocation failed — see logs for details')

    # -----------------------------------------------------------------------
    # Step 4 — Build the findings report and write it to the findings bucket
    # -----------------------------------------------------------------------
    report = _build_report(
        template_bucket=bucket_name,
        template_key=object_key,
        findings_text=findings_text,
        lambda_request_id=context.aws_request_id,
    )

    report_key = _write_findings(report, object_key)
    if report_key is None:
        return _error_response('Failed to write findings report to S3')

    # -----------------------------------------------------------------------
    # Step 5 — Log summary and return
    # -----------------------------------------------------------------------
    logger.info(
        'Security review complete. Template: %s | Report: s3://%s/%s | Risk: %s',
        object_key,
        FINDINGS_BUCKET,
        report_key,
        report.get('overall_risk', 'UNKNOWN'),
    )

    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Security review complete',
            'template': f's3://{bucket_name}/{object_key}',
            'report': f's3://{FINDINGS_BUCKET}/{report_key}',
            'overall_risk': report.get('overall_risk', 'UNKNOWN'),
        }),
    }


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _read_template(bucket: str, key: str) -> str | None:
    """
    Read the CloudFormation template from S3 and return it as a string.
    Returns None if the read fails (error is logged).

    Size guard: if the object exceeds MAX_TEMPLATE_BYTES, the function logs
    a warning and reads only the first MAX_TEMPLATE_BYTES to avoid sending
    an oversized payload to Bedrock.
    """
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        body_bytes = response['Body'].read(MAX_TEMPLATE_BYTES)
        content_length = response.get('ContentLength', 0)

        if content_length > MAX_TEMPLATE_BYTES:
            logger.warning(
                'Template %s is %d bytes, which exceeds the %d-byte limit. '
                'Sending first %d bytes only.',
                key, content_length, MAX_TEMPLATE_BYTES, MAX_TEMPLATE_BYTES,
            )

        template_str = body_bytes.decode('utf-8')
        logger.info('Read template %s (%d bytes)', key, len(template_str))
        return template_str

    except ClientError as exc:
        error_code = exc.response['Error']['Code']
        logger.error('S3 GetObject failed for %s/%s: %s %s', bucket, key, error_code, exc)
        return None

    except UnicodeDecodeError as exc:
        logger.error('Template %s/%s is not valid UTF-8: %s', bucket, key, exc)
        return None


def _invoke_bedrock(template_content: str, template_key: str) -> str | None:
    """
    Submit the CloudFormation template to Bedrock (Claude) for security review.
    Returns the model's response text, or None if the call fails.

    Uses the Messages API (anthropic.claude-3-5-sonnet). Falls back to
    Claude 3 Haiku if the primary model call fails.
    """
    prompt_text = SECURITY_REVIEW_PROMPT.format(template_content=template_content)

    # Bedrock Messages API payload — same structure as the Anthropic Messages
    # API. max_tokens caps the response length; 2048 is sufficient for a
    # structured security findings report on a template of this size.
    request_body = {
        'anthropic_version': 'bedrock-2023-05-31',
        'max_tokens': 2048,
        'messages': [
            {
                'role': 'user',
                'content': prompt_text,
            }
        ],
    }

    for model_id in [BEDROCK_MODEL_ID, BEDROCK_MODEL_FALLBACK_ID]:
        try:
            logger.info('Invoking Bedrock model %s for template %s', model_id, template_key)
            response = bedrock_client.invoke_model(
                modelId=model_id,
                contentType='application/json',
                accept='application/json',
                body=json.dumps(request_body),
            )
            response_body = json.loads(response['body'].read())
            # Claude Messages API returns content as a list of content blocks.
            # The text of the first block is the model's response.
            findings_text = response_body['content'][0]['text']
            logger.info(
                'Bedrock response received from %s (%d characters)',
                model_id, len(findings_text),
            )
            return findings_text

        except ClientError as exc:
            error_code = exc.response['Error']['Code']
            logger.warning(
                'Bedrock InvokeModel failed for model %s: %s %s. '
                'Trying fallback if available.',
                model_id, error_code, exc,
            )

    # Both models failed
    logger.error('All Bedrock model invocations failed for template %s', template_key)
    return None


def _build_report(
    template_bucket: str,
    template_key: str,
    findings_text: str,
    lambda_request_id: str,
) -> dict:
    """
    Build the findings report dict from the Bedrock response.
    Extracts the overall risk rating from the findings text so it can be
    logged and included in the report metadata without parsing the full text.
    """
    reviewed_at = datetime.now(timezone.utc).isoformat()

    # Extract the OVERALL RISK rating from the findings text using a simple
    # regex. Claude reliably includes 'OVERALL RISK: LOW/MEDIUM/HIGH' in its
    # response given the structured prompt above. Defaults to UNKNOWN if not
    # found (e.g. if the model returns an unexpected format).
    risk_pattern = re.search(r'OVERALL RISK\s*[:\-]\s*(LOW|MEDIUM|HIGH)', findings_text, re.IGNORECASE)
    overall_risk = risk_pattern.group(1).upper() if risk_pattern else 'UNKNOWN'

    report = {
        # Report metadata
        'report_version': '1.0',
        'reviewed_at': reviewed_at,
        'lambda_request_id': lambda_request_id,
        'overall_risk': overall_risk,

        # Source template reference
        'template_source': {
            'bucket': template_bucket,
            'key': template_key,
            's3_uri': f's3://{template_bucket}/{template_key}',
        },

        # Full findings text from Bedrock
        'findings': findings_text,

        # Metadata about the review pipeline itself
        'pipeline': {
            'bedrock_model': BEDROCK_MODEL_ID,
            'findings_bucket': FINDINGS_BUCKET,
        },
    }

    return report


def _write_findings(report: dict, template_key: str) -> str | None:
    """
    Write the findings report as a JSON object to the findings S3 bucket.
    The key includes a timestamp and the original template name so reports
    are sorted chronologically and traceable back to their source template.

    Returns the S3 key of the written report, or None if the write fails.
    """
    # Build a clean timestamp string for the key (e.g. 20260806T212400Z)
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')

    # Derive a short name from the template key to make the report filename
    # human-readable. Strip any directory prefix and file extension.
    template_basename = os.path.splitext(os.path.basename(template_key))[0]
    # Replace any characters that are not URL-safe with underscores
    safe_basename = re.sub(r'[^a-zA-Z0-9_\-]', '_', template_basename)

    report_key = f'findings/{timestamp}_{safe_basename}.json'

    try:
        s3_client.put_object(
            Bucket=FINDINGS_BUCKET,
            Key=report_key,
            Body=json.dumps(report, indent=2, ensure_ascii=False).encode('utf-8'),
            ContentType='application/json',
        )
        logger.info('Findings report written to s3://%s/%s', FINDINGS_BUCKET, report_key)
        return report_key

    except ClientError as exc:
        error_code = exc.response['Error']['Code']
        logger.error('S3 PutObject failed for findings report %s: %s %s', report_key, error_code, exc)
        return None


def _error_response(message: str) -> dict:
    """Return a standardised error response dict."""
    logger.error(message)
    return {
        'statusCode': 500,
        'body': json.dumps({'error': message}),
    }
