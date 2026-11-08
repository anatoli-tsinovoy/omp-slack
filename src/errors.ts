export class SlackNotConnectedError extends Error {
 constructor(message: string) {
  super(message);
  this.name = "SlackNotConnectedError";
 }
}

export class SlackAuthError extends Error {
 constructor(message: string, options?: ErrorOptions) {
  super(message, options);
  this.name = "SlackAuthError";
 }
}
