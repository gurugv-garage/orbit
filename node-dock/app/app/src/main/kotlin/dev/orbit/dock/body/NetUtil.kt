package dev.orbit.dock.body

import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Small helpers for the connect dialog: discover the phone's own Wi-Fi
 * IPv4 so we can prefill the octet boxes (the XIAO is usually on the same
 * /24 subnet as the phone).
 */
object NetUtil {

    /** The phone's primary local IPv4 (e.g. "192.168.1.42"), or null. Prefers
     *  a wlan/site-local address over loopback/cellular. */
    fun localIpv4(): String? {
        return try {
            val candidates = mutableListOf<String>()
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (!iface.isUp || iface.isLoopback) continue
                for (addr in iface.inetAddresses) {
                    if (addr is Inet4Address && addr.isSiteLocalAddress) {
                        val name = iface.name.lowercase()
                        // Prefer wlan; otherwise keep as fallback.
                        if (name.startsWith("wlan") || name.startsWith("ap")) {
                            return addr.hostAddress
                        }
                        addr.hostAddress?.let { candidates.add(it) }
                    }
                }
            }
            candidates.firstOrNull()
        } catch (_: Throwable) {
            null
        }
    }

    /** Split an IPv4 into its 4 octet strings, or a sensible default. */
    fun octetsOf(ip: String?): List<String> {
        val parts = ip?.split(".")?.takeIf { it.size == 4 }
        return parts ?: listOf("192", "168", "1", "")
    }

    /** Parse "host:port" → Pair(host, port). Port defaults to 17317. */
    fun splitHostPort(hostPort: String, defaultPort: Int = 17317): Pair<String, Int> {
        val s = hostPort.removePrefix("ws://").removePrefix("wss://").trimEnd('/')
        val idx = s.lastIndexOf(':')
        return if (idx > 0 && idx < s.length - 1) {
            val h = s.substring(0, idx)
            val p = s.substring(idx + 1).toIntOrNull() ?: defaultPort
            h to p
        } else {
            s to defaultPort
        }
    }
}
