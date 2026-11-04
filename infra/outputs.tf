output "base_url" { value = "https://${var.domain_name}" }
output "region" { value = var.region }
output "links_function_name" { value = aws_lambda_function.app["links"].function_name }
output "api_keys_function_name" { value = aws_lambda_function.app["api-keys"].function_name }
output "links_table_name" { value = aws_dynamodb_table.app["links"].name }
output "api_keys_table_name" { value = aws_dynamodb_table.app["api-keys"].name }
