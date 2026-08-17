variable "name" {
  description = "Stable SUMMING host name and resource prefix."
  type        = string
  default     = "summing-production"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.name))
    error_message = "name must be a lowercase DNS-safe identifier."
  }
}

variable "location" {
  description = "Hetzner Cloud location."
  type        = string
  default     = "fsn1"
}

variable "server_type" {
  description = "Hetzner Cloud server type."
  type        = string
  default     = "cpx32"
}

variable "ssh_key_name" {
  description = "Existing Hetzner Cloud SSH key injected for the root operator."
  type        = string
}

variable "ssh_source_cidrs" {
  description = "CIDRs allowed to reach SSH. Never use the world-wide default in production."
  type        = list(string)

  validation {
    condition = length(var.ssh_source_cidrs) > 0 && alltrue([
      for cidr in var.ssh_source_cidrs : can(cidrnetmask(cidr)) && cidr != "0.0.0.0/0" && cidr != "::/0"
    ])
    error_message = "ssh_source_cidrs must contain at least one restricted IPv4/IPv6 CIDR."
  }
}

variable "backups" {
  description = "Enable provider snapshots in addition to application/object-store backups."
  type        = bool
  default     = true
}
