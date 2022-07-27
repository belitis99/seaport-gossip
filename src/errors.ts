export const ErrorInvalidAddress = new Error('invalid address')

export const ErrorOrderNotFound = new Error('order not found')

export const ErrorTokenIdNumberTooLarge = new Error(
  'token id larger than max safe integer, please pass bigint or string instead'
)
