import { expect, test } from "bun:test"
import { encodeCodexQuestionReplies, parseCodexQuestionReplies, formatCodexQuestionReply } from "./codex-questions"

test("native async reply envelope preserves question identity and custom text", () => {
  const replies = [
    { questionItemId: '["request_user_input_async","item",0]', question: "Same?", answer: "One\n<two>" },
    { questionItemId: '["request_user_input_async","item",1]', question: "Same?", answer: "$skill /command" },
  ]
  expect(parseCodexQuestionReplies(encodeCodexQuestionReplies(replies))).toEqual(replies)
  expect(formatCodexQuestionReply(encodeCodexQuestionReplies(replies))).toBe("> Same?\n\nOne\n<two>\n\n> Same?\n\n$skill /command")
  expect(parseCodexQuestionReplies(`<send_user_message_question_reply>${JSON.stringify(replies[0])}</send_user_message_question_reply>`)).toEqual([replies[0]])
})

test("ordinary text and malformed reply envelopes are not interpreted as answers", () => {
  for (const text of ["normal", "<send_user_message_question_reply>[]</send_user_message_question_reply>",
    '<send_user_message_question_reply>{"questionItemId":"q","question":"Q","answer":""}</send_user_message_question_reply>',
    '<send_user_message_question_reply>{broken}</send_user_message_question_reply>',
  ]) {
    expect(parseCodexQuestionReplies(text)).toEqual([])
    expect(formatCodexQuestionReply(text)).toBe(text)
  }
})
