import { defaultLogger } from '@libp2p/logger'
import { expect } from 'aegir/chai'
import delay from 'delay'
import { raceSignal } from 'race-signal'
import { stubInterface } from 'sinon-ts'
import { readCandidatesUntilConnected } from '../src/private-to-private/util.ts'
import type { Message } from '../src/private-to-private/pb/message.ts'
import type { RTCPeerConnection } from '../src/webrtc/index.ts'
import type { Stream } from '@libp2p/interface'
import type { MessageStream } from 'it-protobuf-stream'

describe('signaling recovery cancellation', () => {
  for (const scenario of ['abort read', 'abort after EOF', 'connect after EOF']) {
    it(scenario, async () => {
      const controller = new AbortController()
      const cancelled = new Error('dial cancelled')
      const eof = new Error('signaling EOF')
      const candidate = Promise.withResolvers<Message>()
      const pc = stubInterface<RTCPeerConnection>({
        connectionState: 'connecting',
        onconnectionstatechange: null
      })
      const stream = stubInterface<MessageStream<Message, Stream>>({
        read: async options => {
          if (scenario !== 'abort read') {
            throw eof
          }

          return raceSignal(candidate.promise, options?.signal)
        }
      })
      let outcome: unknown = 'pending'
      const reading = readCandidatesUntilConnected(pc, stream, {
        direction: 'initiator',
        signal: controller.signal,
        log: defaultLogger().forComponent('test:signaling')
      }).then(() => { outcome = 'connected' }, err => { outcome = err })

      function transition (state: RTCPeerConnectionState): void {
        Object.defineProperty(pc, 'connectionState', { value: state, configurable: true })
        pc.onconnectionstatechange?.call(pc as unknown as globalThis.RTCPeerConnection, new Event('connectionstatechange'))
      }

      try {
        // Drain promise continuations so EOF has reached the recovery wait.
        await delay(0)
        expect(outcome).to.equal('pending')

        if (scenario === 'connect after EOF') {
          transition('connected')
        } else {
          controller.abort(cancelled)
        }

        await delay(0)
        expect(outcome).to.equal(scenario === 'connect after EOF' ? 'connected' : cancelled)
      } finally {
        // Also release the original, unbounded implementation on assertion failure.
        controller.abort(cancelled)
        transition('failed')
        await reading
      }
    })
  }
})
