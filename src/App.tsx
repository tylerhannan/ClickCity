import { useState } from 'react'
import { type TableNode } from './types'
import { type Connection, fetchSchema } from './clickhouse/client'
import { MOCK_TABLES } from './data/mockData'
import ConnectionScreen from './components/ConnectionScreen'
import CityCanvas from './components/CityCanvas'
import DetailPanel from './components/DetailPanel'
import Legend from './components/Legend'

export default function App() {
  const [conn, setConn] = useState<Connection | null>(null)
  const [tables, setTables] = useState<TableNode[] | null>(null)
  const [selected, setSelected] = useState<TableNode | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isMock, setIsMock] = useState(false)

  async function handleConnect(c: Connection) {
    setConnecting(true)
    setError(null)
    try {
      const t = await fetchSchema(c)
      if (t.length === 0) {
        setError('Connected, but no user tables were found.')
        return
      }
      setConn(c)
      setTables(t)
      setIsMock(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setConnecting(false)
    }
  }

  function handleMock() {
    setConn(null)
    setTables(MOCK_TABLES)
    setIsMock(true)
    setError(null)
  }

  function disconnect() {
    setTables(null)
    setConn(null)
    setSelected(null)
    setIsMock(false)
  }

  if (!tables) {
    return (
      <ConnectionScreen
        onConnect={handleConnect}
        onMock={handleMock}
        connecting={connecting}
        error={error}
      />
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Click<span>City</span>
        </div>
        <div className="source">
          {isMock ? 'mock data' : conn?.url}
          <span className="count"> · {tables.length} tables</span>
        </div>
        <button className="ghost small" onClick={disconnect}>
          Disconnect
        </button>
      </header>

      <main className="stage">
        <CityCanvas tables={tables} selected={selected} onSelect={setSelected} />
        <Legend tables={tables} />
        {selected && (
          <DetailPanel table={selected} conn={conn} onClose={() => setSelected(null)} />
        )}
      </main>
    </div>
  )
}
