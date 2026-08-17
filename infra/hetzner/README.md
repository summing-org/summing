# SUMMING fresh host provisioning

This Terraform root creates one protected Ubuntu 24.04 host and a Hetzner Cloud
Firewall. Cloud-init contains no application credentials: it installs the OS
dependencies, Node 24, Codex CLI, Caddy, host hardening, and a provisioning
marker only.

```bash
cd infra/hetzner
cp terraform.tfvars.example terraform.tfvars
export HCLOUD_TOKEN=...
terraform init
terraform plan
terraform apply
terraform output -raw fresh_install_target
```

Create the DNS A/AAAA record for the configured Viewer domain, then run
`deploy/install-fresh` from a clean trusted SUMMING checkout. Terraform state is
infrastructure-sensitive and must use an encrypted remote backend or an
operator-protected local directory. Application, Telegram, OpenAI, S3, and Git
deploy-key secrets never belong in Terraform variables or cloud-init user-data.
