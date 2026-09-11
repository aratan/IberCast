import { CID } from 'multiformats/cid'

/**
 * Resolve an IPFS HTTP gateway base for a root CID.
 *
 * Kubo's path gateway (`/ipfs/{cid}/...`) redirects to the subdomain gateway
 * (`{cidv1}.ipfs.localhost:8080/...`). Browsers block that redirect for XHR
 * (CORB/opaque), so we build the subdomain URL directly: it serves straight
 * 200 responses with `Access-Control-Allow-Origin: *`.
 *
 * Honors `?gw=` override; the default targets the local Kubo gateway which
 * holds daemon-pinned content.
 */
export function gatewayBase(cid: string | null | undefined): string {
  const override = new URLSearchParams(location.search).get('gw')
  if (override) return override.replace(/\/+$/, '')
  if (cid) {
    try {
      const v1 = CID.parse(cid).toV1().toString()
      return `http://${v1}.ipfs.localhost:8080`
    } catch {
      /* fall through to plain gateway */
    }
  }
  return 'http://localhost:8080'
}