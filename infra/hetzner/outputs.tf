output "server_id" {
  value = hcloud_server.summing.id
}

output "ipv4_address" {
  value = hcloud_server.summing.ipv4_address
}

output "ipv6_address" {
  value = hcloud_server.summing.ipv6_address
}

output "wait_for_provisioning" {
  value = "ssh root@${hcloud_server.summing.ipv4_address} cloud-init status --wait"
}

output "fresh_install_target" {
  value = "root@${hcloud_server.summing.ipv4_address}"
}
