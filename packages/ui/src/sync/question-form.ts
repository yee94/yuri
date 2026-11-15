/**
 * Pure question-form mapping shared by Web sync and NSH. No runtime imports.
 */

import type { QuestionRequest } from "@/types/question"

export type V2QuestionLike = {
  id: string
  sessionID: string
  questions?: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
  }>
  /** Official 2.0.12 FormInfo fields (question API is gone). */
  title?: string
  fields?: ReadonlyArray<{
    key: string
    type?: string
    title?: string
    description?: string
    options?: ReadonlyArray<{ label?: string; value?: string; description?: string }>
  }>
  metadata?: Record<string, unknown>
  tool?: { messageID?: string; id?: string }
}

/** Official question tool forms (`metadata.kind === "question"`). Other forms stay on FormCard. */
export function isQuestionFormMetadata(metadata: unknown): boolean {
  return !!metadata
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && (metadata as { kind?: unknown }).kind === "question"
}

function toolCallFromQuestionLike(item: V2QuestionLike): QuestionRequest["tool"] | undefined {
  const metadataTool = item.metadata
    && typeof item.metadata.tool === "object"
    && item.metadata.tool
    && !Array.isArray(item.metadata.tool)
    ? item.metadata.tool as { messageID?: unknown; id?: unknown }
    : undefined
  const messageID = typeof item.tool?.messageID === "string" && item.tool.messageID.length > 0
    ? item.tool.messageID
    : typeof metadataTool?.messageID === "string" && metadataTool.messageID.length > 0
      ? metadataTool.messageID
      : undefined
  if (!messageID) return undefined
  const callID = typeof item.tool?.id === "string"
    ? item.tool.id
    : typeof metadataTool?.id === "string"
      ? metadataTool.id
      : ""
  return { messageID, callID }
}

function questionsFromFormFields(item: V2QuestionLike): QuestionRequest["questions"] {
  const fields = item.fields
  if (!fields || fields.length === 0) {
    const title = typeof item.title === "string" && item.title.length > 0 ? item.title : "Form"
    return [{ question: title, header: title, options: [] }]
  }
  return fields.map((field) => {
    const header = (typeof field.title === "string" && field.title.length > 0)
      ? field.title
      : field.key
    const question = (typeof field.description === "string" && field.description.length > 0)
      ? field.description
      : (typeof item.title === "string" && item.title.length > 0 ? item.title : header)
    const options = (field.options ?? []).map((option) => ({
      label: option.label || option.value || "",
      description: typeof option.description === "string" ? option.description : "",
    })).filter((option) => option.label.length > 0)
    return {
      question,
      header,
      options,
      ...(field.type === "multiselect" ? { multiple: true as const } : {}),
    }
  })
}

/**
 * Map v2 form rows (and legacy question.request shapes) onto the local
 * QuestionRequest UI contract. Official 2.0.12 replaced questions with forms.
 */
export function mapV2QuestionRequest(item: V2QuestionLike): QuestionRequest {
  const questions = item.questions && item.questions.length > 0
    ? item.questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options ?? [],
      ...(question.multiple ? { multiple: true } : {}),
    }))
    : questionsFromFormFields(item)
  const tool = toolCallFromQuestionLike(item)
  return {
    id: item.id,
    sessionID: item.sessionID,
    questions,
    ...(tool ? { tool } : {}),
  }
}

/** Build session.form.reply answers with the authoritative field keys and value types. */
export function answersToFormAnswer(
  answers: string[][],
  fields: NonNullable<V2QuestionLike["fields"]>,
): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {}
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    const values = (answers[index] ?? []).map((value) =>
      field.options?.find((option) => (option.label || option.value) === value)?.value ?? value)
    const value = values[0] ?? ""
    if (field.type === "multiselect") answer[field.key] = values
    else if (field.type === "number" || field.type === "integer") {
      const number = Number(value)
      if (!value.trim() || !Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) {
        throw new Error(`Invalid numeric answer for ${field.key}`)
      }
      answer[field.key] = number
    } else if (field.type === "boolean") {
      if (value !== "true" && value !== "false") throw new Error(`Invalid boolean answer for ${field.key}`)
      answer[field.key] = value === "true"
    } else answer[field.key] = value
  }
  // Extra answer rows without field keys are ignored; form schema owns keys.
  return answer
}
