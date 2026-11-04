locals {
  functions = toset(["links", "api-keys"])
  routes = {
    create  = "POST /links"
    resolve = "GET /{code}"
    head    = "HEAD /{code}"
  }
}

resource "aws_iam_role" "lambda" {
  for_each = local.functions
  name     = "${var.name}-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-${each.key}"
  retention_in_days = 14
}

resource "aws_iam_role_policy" "lambda" {
  for_each = local.functions
  role     = aws_iam_role.lambda[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.lambda[each.key].arn}:*"
      }
      ], each.key == "links" ? [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.app["links"].arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.app["api-keys"].arn
      }
      ] : [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:Scan", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.app["api-keys"].arn
      }
    ])
  })
}

data "archive_file" "lambda" {
  for_each    = local.functions
  type        = "zip"
  source_file = "${path.module}/../back/dist/${each.key}.cjs"
  output_path = "${path.module}/.build/${each.key}.zip"
}

resource "aws_lambda_function" "app" {
  for_each         = local.functions
  function_name    = "${var.name}-${each.key}"
  role             = aws_iam_role.lambda[each.key].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "${each.key}.handler"
  filename         = data.archive_file.lambda[each.key].output_path
  source_code_hash = data.archive_file.lambda[each.key].output_base64sha256
  memory_size      = 128
  timeout          = 30
  environment {
    variables = merge({ KEYS_TABLE = aws_dynamodb_table.app["api-keys"].name }, each.key == "links" ? {
      LINKS_TABLE = aws_dynamodb_table.app["links"].name
      BASE_URL    = "https://${var.domain_name}"
    } : {})
  }
  depends_on = [aws_iam_role_policy.lambda, aws_cloudwatch_log_group.lambda]
}

resource "aws_apigatewayv2_api" "app" {
  name                         = var.name
  protocol_type                = "HTTP"
  disable_execute_api_endpoint = true
}

resource "aws_apigatewayv2_integration" "links" {
  api_id                 = aws_apigatewayv2_api.app.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.app["links"].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "links" {
  for_each           = local.routes
  api_id             = aws_apigatewayv2_api.app.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.links.id}"
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "links" {
  for_each      = local.routes
  statement_id  = "InvokeFromApi-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app["links"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.app.execution_arn}/*/${replace(replace(each.value, " ", ""), "{code}", "*")}"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/apigateway/${var.name}"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "app" {
  api_id      = aws_apigatewayv2_api.app.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = var.throttling_burst_limit
    throttling_rate_limit  = var.throttling_rate_limit
  }
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api.arn
    format = jsonencode({
      requestId = "$context.requestId", route = "$context.routeKey",
      status    = "$context.status", latency = "$context.responseLatency"
    })
  }
}
