import { type FormEvent, useState } from 'react'
import { type Connection } from '../clickhouse/client'

interface Props {
  onConnect: (conn: Connection) => void
  onMock: () => void
  connecting: boolean
  error: string | null
}

// Entry screen: enter a ClickHouse HTTP endpoint + credentials, or jump straight
// into the visualizer with mock data.
export default function ConnectionScreen({ onConnect, onMock, connecting, error }: Props) {
  const [url, setUrl] = useState('https://play.clickhouse.com')
  const [user, setUser] = useState('play')
  const [password, setPassword] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    onConnect({ url: url.trim().replace(/\/$/, ''), user: user.trim(), password })
  }

  return (
    <div className="connect-screen">
      <form className="connect-card" onSubmit={submit}>
        <h1 className="logo">
          Click<span>City</span>
        </h1>
        <p className="tagline">An isometric voxel map of your ClickHouse schema.</p>

        <label>
          HTTP endpoint
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:8123"
            spellCheck={false}
            autoCapitalize="off"
          />
        </label>

        <div className="row">
          <label>
            User
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </div>

        <div className="hint">
          Demo preset: <code>https://play.clickhouse.com</code> · Local/self-hosted:{' '}
          <code>http://localhost:8123</code> · ClickHouse Cloud:{' '}
          <code>https://&lt;host&gt;.clickhouse.cloud:8443</code>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="actions">
          <button type="submit" className="primary" disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
          <button type="button" className="ghost" onClick={onMock} disabled={connecting}>
            Explore with mock data
          </button>
        </div>

        <p className="cors-note">
          The browser queries ClickHouse directly, so the server must allow this origin
          (CORS). ClickCity sends <code>add_http_cors_header=1</code>; for Cloud, add this
          origin to the allowed CORS list.
        </p>
      </form>
    </div>
  )
}
