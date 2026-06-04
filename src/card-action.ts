export interface ActionCardResponse {
  card: object
}

export function actionCardResponse(card: object): ActionCardResponse {
  // EventDispatcher forwards this object as card.action.trigger's callback
  // response. Feishu expects the replacement card under the `card` field;
  // returning the raw card JSON, or patching the message before ACK, causes
  // client-side rollback/flicker in practice.
  return { card }
}
