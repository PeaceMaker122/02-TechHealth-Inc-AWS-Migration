

First-off Decisions:

The Web application is running on EC2 instances. These will be in a private subnet (which is the app layer), accessed by the web EC2 instances in the web layer, which will be in the public subnet, and accessed by the customers via ALB.

The infrastructure was manually created in the console first, but I will not be doing this as the requirement for this project is to migrate the infrastructure to infrastructure as code (IaC). 

This is for numerous best practice reasons, including:
• Version control
• Being able to replicate environments
• Tracking who made what changes
• Automating the testing of infrastructure

---

Problem Statement:

TechHealth Inc. created their infrastructure manually through the console 5 years ago, which is a long time in the technology industry, and this is prone to many issues. 

Opposite to the IaC approach mentioned above, the benefits of Infrastructure as Code (IaC) address these challenges. Currently, the infrastructure documentation is outdated, and the current infrastructure does not comply with AWS best practices. 

This needs to be corrected to achieve:
• Efficiency
• High Availability
• Scalability
• Redundancy
• Disaster recovery

---

## Tasks

### 1. Create the Current Architecture

**What this task is solving**

Establishing a clear visual representation of the current infrastructure to understand what exists, identify flaws, and create a baseline to work from before making any changes.

**What I did**
- Created the current infrastructure as a diagram to get a visual overview and spot security risks.
- No corrections were made to the current infrastructure, the goal was to accurately represent the existing situation before addressing it.

**Why I did it**
- Without a clear picture of the current state, it is difficult to identify risks or plan improvements. The diagram serves as the starting point for all subsequent tasks.

**What I rejected**
- Making corrections to the infrastructure at this stage, doing so would misrepresent the actual current state and undermine the purpose of the diagram.

---

### 2. Create the Target-State Architecture

