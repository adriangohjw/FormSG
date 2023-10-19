// import axios from 'axios'
const axios = require('axios')

const createPayment = async (
  amount,
  description,
  email,
  referenceId,
  serviceId,
) => {
  const UNIMPORTANT_VALUES = {
    payer_address: 'zeke says it is not important :)',
    payer_name: 'zeke says it is not important :)',
    payer_identifier: '10charmax',
  }
  return axios.post(
    `https://api-staging.pay.gov.sg/v1/payment-services/${serviceId}/payments`,
    {
      amount_in_cents: amount,
      description,
      payer_email: email,
      reference_id: referenceId,
      metadata: {},
      ...UNIMPORTANT_VALUES,
    },
    {
      headers: {
        'x-api-key': process.env.PAYSG_API_KEY,
      },
    },
  )
}

// const fooCreatePayment = async (req: Request, res: Response) => {
//   const { body } = req
//   //   const { amount, currency, description, source } = body
//   const amount = 1234
//   const email = 'ken@open.gov.sg'
//   const description = 'formsg test first payment'
//   const referenceId = 'submissionid-0001'
//   const payment = await createPayment(amount, description, email, referenceId)
//   //   res.json(payment)
// }

const amount = 1234
const email = 'ken@open.gov.sg'
const description = 'formsg test first payment'
const referenceId = 'submissionid-0001'
// this serviceId should come from the agency/admin
const serviceId = 'payment_service_fe5b1b0b-065a-43b8-939d-03ab2b67ede9'
const results = createPayment(
  amount,
  description,
  email,
  referenceId,
  serviceId,
)

results.then((e) => console.log(e)) // .catch((e) => console.error(e))
