# Frida Web (Experimental)

Browser-compatible Frida client using WebSocket D-Bus communication.

## Why

Frida traditionally requires D-Bus, which depends on operating system sockets that are not available in browser environments. While proxy-based workarounds exist, they introduce unnecessary complexity since Frida already expects D-Bus messages over WebSocket.  

**Frida Web** removes that barrier by sending and receiving marshalled D-Bus messages directly over WebSocket, making it possible to control a running Frida instance straight from the browser.  

Go to [https://zahidaz.github.io/frida_web/](https://zahidaz.github.io/frida_web/) and try it for yourself.


## Features

- **Browser Compatible** - Works in modern browsers without Node.js dependencies
- **WebSocket D-Bus** - Communicates with Frida server over WebSocket using D-Bus protocol
- **Lightweight** - Minimal dependencies, optimized bundle size

## Installation

### NPM
```bash
npm install frida-web
```

### CDN
```html
<script type="module">
  import { Client } from 'https://unpkg.com/frida-web/dist/frida-web.js';
</script>
```

### Git
```bash
git clone https://github.com/yourusername/frida-web.git
cd frida-web
npm install
npm run build
```

## Usage

### Basic Example

```javascript
import { Client } from 'frida-web';

const client = new Client('localhost:27042');

// Get system information
const systemInfo = await client.querySystemParameters();
console.log(systemInfo);

// List processes
const processes = await client.enumerateProcesses();
console.log(processes);

// Attach to process
const session = await client.attach(1234);
```

### Browser Usage

```html
<!DOCTYPE html>
<html>
<head>
    <title>Frida Web Client</title>
</head>
<body>
    <script type="module">        
        import { Client } from 'https://unpkg.com/frida-web/dist/frida-web.js';
        
        async function init() {
            try {
                const info = await client.querySystemParameters();
                console.log('System Info:', info);
                
                const processes = await client.enumerateProcesses();
                console.log('Processes:', processes);
            } catch (error) {
                console.error('Error:', error);
            }
        }
        
        init();
    </script>
</body>
</html>
```

### Node.js Usage

```javascript
// ES Modules
import { Client } from 'frida-web';

// CommonJS
const { Client } = require('frida-web');

const client = new Client('localhost:27042');
```

## API Reference

### Client

#### Constructor
```typescript
new Client(host: string, options?: ClientOptions)
```

- `host` - Frida server host and port (e.g., 'localhost:27042')
- `options` - Optional configuration object

#### Methods

##### querySystemParameters()
```typescript
querySystemParameters(): Promise<any>
```
Returns system information from the Frida server.

##### enumerateProcesses(options?)
```typescript
enumerateProcesses(options?: ProcessQueryOptions): Promise<Process[]>
```
Lists all processes visible to Frida.

##### attach(pid, options?)
```typescript
attach(pid: number, options?: SessionOptions): Promise<Session>
```
Attaches to a process and returns a session for script injection.

### Types

```typescript
interface Process {
  pid: number;
  name: string;
  parameters: VariantDict;
}

interface ClientOptions {
  tls?: 'auto' | 'enabled' | 'disabled';
  token?: string;
}

interface ProcessQueryOptions {
  pids?: number[];
  scope?: 'minimal' | 'metadata' | 'full';
}
```

## Building

```bash
# Install dependencies
npm install

# Build all formats
npm run build

# Build specific formats
npm run build:esm      # ES modules
npm run build:cjs      # CommonJS
npm run build:browser  # Browser bundle
npm run build:types    # TypeScript declarations

# Development
npm run dev            # Watch mode
```

## Requirements

- Modern browser with ES2020 support
- Frida server with WebSocket D-Bus endpoint
- Node.js 16+ (for development)

## Acknowledgments

Special thanks to [@clebert](https://github.com/clebert) for the excellent [d-bus-message-protocol](https://github.com/clebert/d-bus-message-protocol) library that makes this browser-compatible D-Bus communication possible.

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request