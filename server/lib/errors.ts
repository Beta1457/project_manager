export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (msg: string) => new HttpError(409, msg);
export const forbidden = (msg: string) => new HttpError(403, msg);
