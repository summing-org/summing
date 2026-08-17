terraform {
  required_version = ">= 1.8.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.68"
    }
  }
}

provider "hcloud" {}

data "hcloud_ssh_key" "operator" {
  name = var.ssh_key_name
}

resource "hcloud_firewall" "summing" {
  name = "${var.name}-firewall"

  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_source_cidrs
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "summing" {
  name               = var.name
  image              = "ubuntu-24.04"
  server_type        = var.server_type
  location           = var.location
  ssh_keys           = [data.hcloud_ssh_key.operator.id]
  firewall_ids       = [hcloud_firewall.summing.id]
  backups            = var.backups
  delete_protection  = true
  rebuild_protection = true
  user_data          = file("${path.module}/../../deploy/cloud-init.yaml")

  labels = {
    application = "summing"
    lifecycle   = "fresh-install"
  }

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }
}
