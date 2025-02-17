variable "deploy_to_ngap" {
  description = "Whether or not this instance of Cumulus is deployed to an NGAP environment"
  type        = bool
}

variable "prefix" {
  type        = string
  description = "Resource prefix unique to this deployment"
}

variable "oauth_client_id" {
  type        = string
  description = "oauth_client_id"
}

variable "oauth_client_password" {
  type        = string
  description = "oauth_client_password"
}

variable "oauth_host_url" {
  type        = string
  description = "oauth_host_url"
}

# Optional

variable "api_url" {
  type        = string
  default     = null
  description = "If not specified, the value of the API Gateway endpoint is used"
}

variable "api_gateway_stage" {
  type        = string
  default     = "dev"
  description = "The API Gateway stage name for the distribution App"
}

variable "cmr_acl_based_credentials" {
  type = bool
  default = false
  description = "Option to enable/disable user based CMR ACLs to derive permission for s3 credential access tokens"
}

variable "cmr_environment" {
  description = "The CMR environment to access"
  type        = string
  default     = null
}

variable "cmr_provider" {
  description = "The provider used to search CMR ACLs"
  type        = string
  default     = null
}

variable "lambda_subnet_ids" {
  type    = list(string)
  default = []
  description = "VPC subnets used by Lambda functions"
}

variable "oauth_provider" {
  type        = string
  default     = "cognito"
  description = "The OAuth provider, cognito or earthdata"
}

variable "permissions_boundary_arn" {
  type        = string
  default     = null
  description = "The ARN of an IAM permissions boundary to use when creating IAM policies"
}

variable "sts_credentials_lambda_function_arn" {
  type        = string
  default     = null
  description = "ARN of lambda function that provides app owners with keys that can be passed on to their app users."
}

variable "sts_policy_helper_lambda_function_arn" {
  type        = string
  default     = null
  description = "ARN of lambda function that outputs session policies to be passed to the sts key lambda."
}

variable "protected_buckets" {
  type        = list(string)
  default     = []
  description = "A list of protected buckets"
}

variable "public_buckets" {
  type        = list(string)
  default     = []
  description = "A list of public buckets"
}

variable "tags" {
  description = "Tags to be applied to managed resources"
  type        = map(string)
  default     = {}
}

variable "vpc_id" {
  type        = string
  description = "VPC used by Lambda functions"
  default     = null
}
