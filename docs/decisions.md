

First-off Decisions:

The Web application is running on EC2 instances. These would normally be in the private subnet (which is the app layer), but for this project's use case, they will be put into the public subnet to save costs by NOT implementing a NAT gateway for the app layer when creating the infrastructure.

The infrastructure was manually created in the console first, but I will not be doing this as the requirement for this project is to migrate the infrastructure to infrastructure as code (IaC). 

This is for numerous best practice reasons, including:
• Version control
• Being able to replicate environments
• Tracking who made what changes
• Automating the testing of infrastructure



Problem Statement:

TechHealth Inc. created their infrastructure manually through the console 5 years ago, which is a long time in the technology industry, and this is prone to many issues. 

Opposite to the IaC approach mentioned above, the benefits of Infrastructure as Code (IaC) address these challenges. Currently, the infrastructure documentation is outdated, and the current infrastructure does not comply with AWS best practices. 

This needs to be corrected to achieve:
• Efficiency
• High Availability
• Scalability
• Redundancy
• Disaster recovery