variable "name" {
  type    = string
  default = "short-link"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.name))
    error_message = "Use 3 a 30 letras minúsculas, números ou hífens, iniciando com letra."
  }
}

variable "region" {
  type    = string
  default = "sa-east-1"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "hosted_zone_name" {
  type    = string
  default = "lucas-tavares.com"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.hosted_zone_name)) && !strcontains(var.hosted_zone_name, "..")
    error_message = "Informe o nome da zona pública, sem protocolo ou ponto final."
  }
}

variable "domain_name" {
  type    = string
  default = "link.lucas-tavares.com"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.domain_name)) && !strcontains(var.domain_name, "..") && endswith(var.domain_name, ".${var.hosted_zone_name}")
    error_message = "Informe um subdomínio válido da zona pública configurada."
  }
}

variable "throttling_rate_limit" {
  type    = number
  default = 10
  validation {
    condition     = var.throttling_rate_limit > 0
    error_message = "Informe um limite positivo de requisições por segundo."
  }
}

variable "throttling_burst_limit" {
  type    = number
  default = 20
  validation {
    condition     = var.throttling_burst_limit >= 1 && floor(var.throttling_burst_limit) == var.throttling_burst_limit
    error_message = "Informe um limite inteiro positivo."
  }
}
