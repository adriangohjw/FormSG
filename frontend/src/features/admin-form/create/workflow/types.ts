import {
  FormWorkflowStep,
  FormWorkflowStepDynamic,
  FormWorkflowStepStatic,
  WorkflowType,
} from '~shared/types'

export enum AdminEditWorkflowState {
  CreatingStep,
  EditingStep,
}

export type EditStepInputs = Omit<FormWorkflowStep, 'emails'> & {
  workflow_type: WorkflowType
  emails?: FormWorkflowStepStatic['emails']
  field?: FormWorkflowStepDynamic['field']
}
