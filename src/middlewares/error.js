import { AppError } from '../utils/AppError.js';

export const notFound = (_req, _res, next) => next(new AppError('NOT_FOUND', 404));
export const errorHandler = (error, req, res, _next) => {
  // A timed-out request may finish or fail after its 504 was already sent.
  if (res.headersSent) return _next(error);
  const sqlState = error.code === 'P2010' ? error.meta?.code : undefined;
  const prismaStatus=error.code==='P2002'||['23505','23P01'].includes(sqlState)?409:error.code==='P2025'?404:error.code==='P2024'?503:
    error.code==='P2004'||sqlState==='23514'?400:error.code==='P2003'||sqlState==='23503'?409:undefined;
  const status = error instanceof AppError ? error.statusCode : prismaStatus ?? (
    error.statusCode === 413 || error.status === 413 || error.code==='LIMIT_FILE_SIZE' || error.type==='entity.too.large' ? 413 :
    error.statusCode === 415 || error.status === 415 || error.type==='charset.unsupported' || error.type==='encoding.unsupported' ? 415 :
    error.statusCode === 400 || error.status === 400 || error.type==='entity.parse.failed' ||
      ['LIMIT_UNEXPECTED_FILE','LIMIT_FILE_COUNT','LIMIT_FIELD_COUNT','LIMIT_PART_COUNT','LIMIT_FIELD_KEY','LIMIT_FIELD_VALUE'].includes(error.code) ? 400 :
    error.status === 429 ? 429 : 500
  );
  const code = error instanceof AppError ? error.code : status===409?'CONFLICT':error.code==='P2025'?'NOT_FOUND':error.code==='P2024'?'SERVICE_UNAVAILABLE':status===413 ? 'PAYLOAD_TOO_LARGE' : status===415 ? 'UNSUPPORTED_MEDIA_TYPE' : status===400 ? 'INVALID_REQUEST' : error.status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR';
  if (status >= 500) req.log?.error({ err: error, requestId: req.id }, 'Request failed');
  const message=error instanceof AppError?error.message:status===404?'Not found.':status===409?'The request conflicts with existing data.':status===413?'The request is too large.':status===415?'The media type is not supported.':status===429?'Too many requests.':status===503?'The service is temporarily unavailable.':status===504?'The request timed out.':status===400?'The request is invalid.':'An unexpected error occurred.';
  res.status(status).json({ error: { code, message, ...(error instanceof AppError&&error.details ? { details: error.details } : {}) }, requestId:req.id });
};
