resource "aws_dynamodb_table" "app" {
  for_each       = { links = "pk", api-keys = "keyId" }
  name           = "${var.name}-${each.key}"
  billing_mode   = "PROVISIONED"
  table_class    = "STANDARD"
  read_capacity  = 1
  write_capacity = 1
  hash_key       = each.value

  attribute {
    name = each.value
    type = "S"
  }

  point_in_time_recovery { enabled = false }
  # Default encryption uses an AWS-owned key; no paid customer-managed KMS key.
  lifecycle { prevent_destroy = true }
}
