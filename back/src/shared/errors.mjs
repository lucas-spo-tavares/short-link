export class AppError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const transientNames = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'ThrottlingError',
  'RequestLimitExceeded',
  'TransactionConflictException',
  'TransactionInProgressException',
  'InternalServerError',
  'ServiceUnavailable',
  'TimeoutError',
  'AbortError',
]);

export function isTransient(error) {
  return (
    transientNames.has(error?.name) ||
    error?.$retryable !== undefined ||
    error?.$metadata?.httpStatusCode >= 500 ||
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code)
  );
}

export function isRetryableTransaction(error) {
  if (isTransient(error)) return true;
  if (error?.name !== 'TransactionCanceledException') return false;
  const reasons = error.CancellationReasons;
  const allowed = new Set([
    'None',
    'ConditionalCheckFailed',
    'TransactionConflict',
    'ProvisionedThroughputExceeded',
    'ThrottlingError',
  ]);
  return Array.isArray(reasons) && reasons.length > 0 && reasons.every((r) => allowed.has(r.Code));
}

export function publicError(error) {
  if (error instanceof AppError) return error;
  if (isTransient(error) || error?.name === 'TransactionCanceledException') {
    return new AppError(503, 'temporarily_unavailable');
  }
  return new AppError(500, 'internal_error');
}
