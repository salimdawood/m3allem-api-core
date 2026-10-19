export class AppError extends Error {
  constructor(code, statusCode, message = code) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
