# Feature Context Toggle

Developer feature-toggle dashboard for the ConFuse platform — a private dev
tool for controlling features, bypassing authentication during testing, and
enabling debug modes.

> This is the canonical README for the service; **all documentation lives in
> [`docs/`](./)** (this folder). See [index.md](index.md) for the docs index.

**Service**: `feature-context-toggle/` · **API port**: `3099` ·
**Dashboard**: `5173` · **Stack**: Node/Express TS + Vite React + PostgreSQL

> [!IMPORTANT]
> **Development Environment Only** — toggles configured here affect local
> development servers after restart; they do **not** affect production.

## Available Toggles

| Toggle | Description |
|--------|-------------|
| **Auth Bypass** | Bypass authentication and use a demo user for testing |
| **Debug Logging** | Enable verbose debug logging across all services |
| **Skip Rate Limiting** | Disable rate limiting for API endpoints during testing |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (incl. dependency status) |
| `/api/toggles` | GET/POST | List all toggles / create toggle |
| `/api/toggles/categories` | GET | Unique categories |
| `/api/toggles/audit` | GET | Recent audit log |
| `/api/toggles/bulk` | POST | Bulk update toggles |
| `/api/toggles/:name` | GET/PATCH/DELETE | Read / enable-disable / delete |
| `/api/toggles/:name/metadata` | PATCH | Update toggle metadata |
| `/api/toggles/:name/history` | GET | Toggle audit history |
| `/api/toggles/auth-bypass/user` | GET | Demo user (when bypass enabled) |
| `/api/logs` | POST | Frontend log ingestion |

Full schemas: [api-reference.md](api-reference.md).

## How to run the microservice

```bash
# Install dependencies
npm install

# Start both backend and frontend
npm run dev
```

- **Dashboard**: http://localhost:5173
- **Backend API**: http://localhost:3099

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend server port | `3099` |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | PostgreSQL | Required |
| `DB_SCHEMA` | Database schema | `feature_toggles` |
| `FRONTEND_PORT` | Dashboard port (dev) | `5173` |

## Integration with auth-middleware

The auth-middleware service queries this toggle service to check if
authentication should be bypassed:

```typescript
const response = await fetch('http://localhost:3099/api/toggles/auth-bypass/user');
if (response.ok) {
  const { data } = await response.json();
  // Use demo user instead of requiring authentication
}
```

## Project Structure

```
feature-context-toggle/
├── backend/          # Express + TypeScript API
│   └── src/
│       ├── index.ts       # Server entry point
│       ├── database.ts    # PostgreSQL connection (NeonDB or container)
│       ├── cache.ts       # Redis caching layer
│       ├── config.ts      # Environment configuration
│       └── routes/
│           └── toggles-db.ts  # Toggle API routes
├── frontend/         # Vite + React dashboard
├── database/
│   └── schema.sql    # PostgreSQL schema
└── package.json      # Monorepo root
```

## Testing

Tests for this service live in the central test module (this service contains
no tests):

```bash
cd ../ConFuse-test-module
pip install -r requirements.txt
pytest feature_toggle -v
```

## Documentation

| Document | Contents |
|----------|----------|
| [index.md](index.md) | Overview & docs index |
| [api-reference.md](api-reference.md) | Full endpoint reference |
| [architecture.md](architecture.md) | Internal architecture |
| [setup.md](setup.md) | Local development setup |

## License

Private — Internal use only
