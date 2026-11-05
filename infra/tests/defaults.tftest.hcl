mock_provider "aws" {
  mock_resource "aws_apigatewayv2_api" {
    defaults = { execution_arn = "arn:aws:execute-api:sa-east-1:123456789012:mock" }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:sa-east-1:123456789012:log-group:mock" }
  }

  mock_resource "aws_dynamodb_table" {
    defaults = { arn = "arn:aws:dynamodb:sa-east-1:123456789012:table/mock" }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:sa-east-1:123456789012:function:mock"
      invoke_arn = "arn:aws:apigateway:sa-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:sa-east-1:123456789012:function:mock/invocations"
    }
  }

  mock_resource "aws_acm_certificate_validation" {
    defaults = { certificate_arn = "arn:aws:acm:sa-east-1:123456789012:certificate/00000000-0000-4000-8000-000000000000" }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:sa-east-1:123456789012:certificate/00000000-0000-4000-8000-000000000000"
      domain_validation_options = [{
        domain_name           = "link.lucas-tavares.com"
        resource_record_name  = "_validation.link.lucas-tavares.com"
        resource_record_type  = "CNAME"
        resource_record_value = "_validation.acm-validations.aws"
      }]
    }
  }
}

run "personal_backend" {
  command = apply

  assert {
    condition = alltrue([
      for table in aws_dynamodb_table.app :
      table.billing_mode == "PROVISIONED" && table.table_class == "STANDARD" &&
      table.read_capacity == 1 && table.write_capacity == 1 &&
      table.point_in_time_recovery[0].enabled == false
    ])
    error_message = "As tabelas devem manter capacidade mínima provisionada Standard e PITR desativado."
  }

  assert {
    condition     = length(aws_lambda_function.app) == 2 && length(aws_apigatewayv2_route.links) == 3
    error_message = "O backend deve ter duas Lambdas e apenas três rotas HTTP."
  }

  assert {
    condition     = alltrue([for route in aws_apigatewayv2_route.links : route.authorization_type == "NONE"])
    error_message = "A resolução é pública e a autenticação de criação ocorre no handler de links."
  }

  assert {
    condition     = aws_apigatewayv2_domain_name.app.domain_name == "link.lucas-tavares.com" && aws_apigatewayv2_api.app.disable_execute_api_endpoint
    error_message = "O acesso público deve usar o domínio personalizado."
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.lambda["api-keys"].policy).Statement[1].Resource == aws_dynamodb_table.app["api-keys"].arn
    error_message = "A Lambda administrativa deve acessar apenas a tabela de chaves."
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.lambda["links"].policy).Statement[2].Action == ["dynamodb:GetItem", "dynamodb:ConditionCheckItem"]
    error_message = "A Lambda de links deve apenas ler e conferir condições na tabela de chaves."
  }
}
