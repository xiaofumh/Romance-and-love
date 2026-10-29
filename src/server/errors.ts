export class AppError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}
export const fail = (code: string, message: string, retryable = false): never => {
  throw new AppError(code, message, retryable);
};
