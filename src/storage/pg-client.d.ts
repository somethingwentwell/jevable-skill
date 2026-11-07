/** The pinned pg package exposes its JavaScript client independently of optional native selection. */
declare module 'pg/lib/client.js' {
  import { Client } from 'pg'
  export default Client
}
