export interface ActionCardResponse {
  card: {
    type: 'raw'
    data: object
  }
}

export function actionCardResponse(card: object): ActionCardResponse {
  // EventDispatcher forwards this object as card.action.trigger's callback
  // response. Feishu expects JSON cards under `card.type=raw` + `card.data`;
  // returning the raw card JSON, or patching the message before ACK, causes
  // callback format errors or client-side rollback/flicker in practice.
  return { card: { type: 'raw', data: card } }
}
