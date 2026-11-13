# CKAD curriculum v1.37

Source: `CKAD_Curriculum_v1.37.pdf` (see `README.md` for URL, checksum and license).
"This document provides the curriculum outline of the Knowledge, Skills and Abilities that a
Certified Kubernetes Application Developer (CKAD) can be expected to demonstrate."

## 20% - Application Design and Build

- Define, build and modify container images
- Choose and use the right workload resource (Deployment, DaemonSet, CronJob, etc.)
- Understand multi-container Pod design patterns (e.g. sidecar, init and others)
- Utilize persistent and ephemeral volumes

## 20% - Application Deployment

- Use Kubernetes primitives to implement common deployment strategies (e.g. blue/green or canary)
- Understand Deployments and how to perform rolling updates
- Use the Helm package manager to deploy existing packages
- Kustomize

## 15% - Application Observability and Maintenance

- Understand API depreciations
- Implement probes and health checks
- Use built-in CLI tools to monitor Kubernetes applications
- Utilize container logs
- Debugging in Kubernetes

## 25% - Application Environment, Configuration and Security

- Discover and use resources that extend Kubernetes (CRD, Operators)
- Understand authentication, authorization and admission control
- Understand requests, limits, quotas
- Define resource requirements
- Understand ConfigMaps
- Create & consume Secrets
- Understand ServiceAccounts
- Understand Application Security (SecurityContexts, Capabilities, etc.)

## 20% - Services and Networking

- Demonstrate basic understanding of NetworkPolicies
- Provide and troubleshoot access to applications via services
- Use Ingress rules to expose applications
