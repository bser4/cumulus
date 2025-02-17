terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 3.0,!= 3.14.0"
    }
  }
}

resource "aws_lambda_function" "provision_database" {
  function_name    = "${var.prefix}-ProvisionPostgresDatabase"
  description      = "Bootstrap lambda that adds user/database to RDS database"
  filename         = "${path.module}/dist/webpack/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/webpack/lambda.zip")
  handler          = "index.handler"
  role             = aws_iam_role.db_provision.arn
  runtime          = "nodejs12.x"
  memory_size      = 256
  timeout          = 500
  environment {
    variables = {
      dbHeartBeat = var.rds_connection_heartbeat
    }
  }


  dynamic "vpc_config" {
    for_each = length(var.subnet_ids) == 0 ? [] : [1]
    content {
      subnet_ids         = var.subnet_ids
      security_group_ids = [var.rds_security_group, aws_security_group.db_provision[0].id]
    }
  }
  tags = var.tags
}

resource "aws_security_group" "db_provision" {
  count = length(var.subnet_ids) == 0 ? 0 : 1

  name_prefix = "${var.prefix}-db-provision"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

resource "aws_iam_role" "db_provision" {
  name_prefix          = "${var.prefix}_db_provision"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role_policy.json
  permissions_boundary = var.permissions_boundary_arn

  tags = var.tags
}

resource "aws_iam_role_policy" "db_provision" {
  name_prefix = "${var.prefix}_db_provision"
  role        = aws_iam_role.db_provision.id
  policy      = data.aws_iam_policy_document.db_provision.json
}

resource "aws_secretsmanager_secret" "db_credentials" {
  name_prefix = "${var.prefix}_db_login"
  description = "Database Credentials Object for ${var.prefix} stack"
  tags        = var.tags
}

data "aws_iam_policy_document" "lambda_assume_role_policy" {
  statement {
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

data "aws_iam_policy_document" "db_provision" {
  statement {
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents"
    ]
    resources = ["*"]
  }
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue"
    ]
    resources = [aws_secretsmanager_secret.db_credentials.arn]
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.rds_admin_access_secret_arn]
  }
}

data "aws_lambda_invocation" "provision_database" {
  depends_on    = [aws_lambda_function.provision_database]
  function_name = aws_lambda_function.provision_database.function_name
  input = jsonencode({ prefix = var.prefix,
    rootLoginSecret    = var.rds_admin_access_secret_arn,
    userLoginSecret    = aws_secretsmanager_secret.db_credentials.name
    dbPassword         = var.rds_user_password
    replacementTrigger = timestamp()
    dbRecreation       = var.dbRecreation
  })
}
