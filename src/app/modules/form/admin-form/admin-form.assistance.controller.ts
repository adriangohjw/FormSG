import { ChatCompletionMessage } from 'openai/src/resources/chat/completions'

import { ErrorDto } from '../../../../../shared/types'
import { ControllerHandler } from '../../core/core.types'

import {
  generateFormFields,
  generateQuestions,
} from './admin-form.assistance.service'

export const handleGenerateQuestions: ControllerHandler<
  unknown,
  ChatCompletionMessage | ErrorDto,
  { purpose: string }
> = async (req, res) => {
  const result = await generateQuestions(req.body.purpose)
  if (result.isErr()) {
    return res.status(500).json({ message: result.error.message })
  }
  res.status(200).json(result.value)
}
export const handleGenerateFormFields: ControllerHandler<
  unknown,
  ChatCompletionMessage | ErrorDto,
  {
    type: string
    content: string
  }
> = async (req, res) => {
  const result = await generateFormFields(req.body)
  if (result.isErr()) {
    return res.status(500).json({ message: result.error.message })
  }
  res.status(200).json(result.value)
}
