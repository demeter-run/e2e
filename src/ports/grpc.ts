import { Client, credentials, Metadata, type ServiceError, status } from '@grpc/grpc-js'

/**
 * One unary gRPC call over TLS, with messages encoded by hand (`proto.ts`):
 * no proto files are vendored. fabric's API and UTxO RPC both speak native
 * gRPC on 443, which is what fabric's script reached with `grpcurl`.
 */
export interface Call {
  /** `host:port`. */
  address: string
  /** `/package.Service/Method`. */
  method: string
  request: Uint8Array
  headers?: Record<string, string>
  timeoutMs?: number
}

export async function unary({ address, method, request, headers = {}, timeoutMs = 15_000 }: Call): Promise<Uint8Array> {
  const client = new Client(address, credentials.createSsl())
  const metadata = new Metadata()
  for (const [name, value] of Object.entries(headers)) metadata.set(name, value)
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      client.makeUnaryRequest(
        method,
        (message: Uint8Array) => Buffer.from(message),
        (bytes: Buffer) => new Uint8Array(bytes),
        request,
        metadata,
        { deadline: Date.now() + timeoutMs },
        (error: ServiceError | null, response?: Uint8Array) => {
          if (error) reject(new Error(`${method.split('/').pop()}: ${describe(error)}`))
          else resolve(response ?? new Uint8Array())
        },
      )
    })
  } finally {
    client.close()
  }
}

/** A failed call as a step reports it: the status name and fabric's message. */
function describe(error: ServiceError): string {
  const name = status[error.code] ?? String(error.code)
  return error.details ? `${name} (${error.details})` : name
}
