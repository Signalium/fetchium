/** A REST mutation's non-2xx response. `response` is left unread for callers that need the body. */
export class RESTResponseError extends Error {
  readonly status: number;
  readonly response: Response;

  constructor(response: Response) {
    super(`Request failed with status ${response.status}`);
    this.name = 'RESTResponseError';
    this.status = response.status;
    this.response = response;
  }
}
