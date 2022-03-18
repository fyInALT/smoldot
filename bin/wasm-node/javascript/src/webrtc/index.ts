// Smoldot
// Copyright (C) 2019-2022  Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later WITH Classpath-exception-2.0

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// # Overview
//
// ## ICE
//
// RFCs: 8839, 8445
// See also: https://tools.ietf.org/id/draft-ietf-rtcweb-sdp-08.html#rfc.section.5.2.3
//
// The WebRTC protocol uses ICE in order to establish a connection.
//
// In a typical ICE setup, there are two endpoints, called agents, that want to communicate. One
// of these two agents is the local browser, while the other agent is the target of the
// connection.
//
// Even though in this specific context all we want is a simple client-server communication, it
// is helpful to keep in mind that ICE was designed to solve the problem of NAT traversal.
//
// The ICE workflow works as follows:
//
// - An "offerer" (the local browser) determines ways in which it could be accessible (either an
//   IP address or through a relay using a TURN server), which are called "candidates". It then
//   generates a small text payload in a format called SDP, that describes the request for a
//   connection.
// - The offerer sends this SDP-encoded message to the answerer. The medium through which this
//   exchange is done is out of scope of the ICE protocol.
// - The answerer then finds its own candidates, and generates an answer, again in the SDP format.
//   This answer is sent back to the offerer.
// - Each agent then tries to connect to the remote's candidates.
//
// The code below only runs on one of the two agents, and simulates steps 2 and 3.
// We pretend to send the offer to the remote agent (the target of the connection), then pretend
// that it has found a valid IP address for itself (i.e. a candidate), then pretend that the SDP
// answer containing this candidate has been sent back.
// This will cause the browser to execute step 4: try to connect to the remote's candidate.
//
// This process involves parsing the offer generated by the browser in order for the answer to
// match the browser's demands.
//
// ## TCP or UDP
//
// The SDP message generated by the offerer contains the list of so-called "media streams" that it
// wants to open. In our specific use-case, we configure the browser to always request one data
// stream.
//
// WebRTC by itself doesn't hardcode any specific protocol for these media streams. Instead, it is
// the SDP message of the offerer that specifies which protocol to use. In our use case, one data
// stream, we know that the browser will always request either TCP+DTLS+SCTP, or UDP+DTLS+SCTP.
//
// After the browser generates an SDP offer (by calling `createOffer`), we are allowed to tweak
// the actual SDP payload that we pass to `setLocalDescription` and that the browser will actually
// end up using for its local description. Thanks to this, we can force the browser to use TCP
// or to use UDP, no matter which one of the two it has requested in its offer.
//
// ## DTLS+SCTP
//
// RFCs: 8841, 8832
//
// In both cases (TCP or UDP), the next layer is DTLS. DTLS is similar to the well-known TLS
// protocol, except that it doesn't guarantee ordering of delivery (as this is instead provided
// by the SCTP layer on top of DTLS). In other words, once the TCP or UDP connection is
// established, the browser will try to perform a DTLS handshake.
//
// During the ICE negotiation, each agent must include in its SDP packet a hash of the self-signed
// certificate that it will use during the DTLS handshake.
// In our use-case, where we try to hand-crate the SDP answer generated by the remote, this is
// problematic as at this stage we have no way to know the certificate that the remote is going
// to use.
//
// To solve that problem, instead of each node generating their own random certificate, like you
// normally would, every libp2p node uses the same hardcoded publicly-known certificate.
// As such, the TLS layer won't offer any protection and another encryption layer will need to be
// negotiated on top of the DTLS+SCTP stream, like is the case for plain TCP connections.
//
// TODO: this is only one potential solution; see ongoing discussion in https://github.com/libp2p/specs/issues/220
// # About main thread vs worker
//
// You might wonder why this code is not executed within the WebWorker.
// The reason is that at the time of writing it is not allowed to create WebRTC connections within
// a WebWorker.
//
// See also https://github.com/w3c/webrtc-extensions/issues/64
//

export default function(targetIp: string, protocol: 'tcp' | 'udp', targetPort: number) {
    // Create a new peer connection.
    const pc = new RTCPeerConnection();

    // Create a new data channel. This will trigger a new negotiation (see
    // `negotiationneeded` handler below).
    const dataChannel = pc.createDataChannel("data");

    // Log any connection state changes.
    pc.onconnectionstatechange = (_event) => {
        console.log("conn state: " + pc.connectionState);
    };

    // Log any ICE connection state changes.
    pc.oniceconnectionstatechange = (_event) => {
        console.log("ICE conn state: " + pc.iceConnectionState);
    };

    // When a new negotion is triggered, set both local and remote descriptions.
    pc.onnegotiationneeded = async (_event) => {
        // Create a new offer and set it as local description.
        var sdpOffer = (await pc.createOffer()).sdp!;
        // Replace ICE user and password with ones expected by the server.
        sdpOffer = sdpOffer.replace(/^a=ice-ufrag.*$/m, 'a=ice-ufrag:V6j+')
        sdpOffer = sdpOffer.replace(/^a=ice-pwd.*$/m, 'a=ice-pwd:OEKutPgoHVk/99FfqPOf444w');
        // Replace trickle option with ice2 since we won't be sending any
        // additional candidates.
        sdpOffer = sdpOffer.replace(/^a=ice-options:.*$/m, 'a=ice-options:ice2');
        await pc.setLocalDescription({ type: 'offer', sdp: sdpOffer });

        console.log(pc.localDescription!.sdp);

        // Use the fake SDP response, which normally the client would've
        // received through the STUN server.
        //
        // Note that the trailing line feed is important, as otherwise Chrome
        // fails to parse the payload.
        const remoteSdp =
            // Version of the SDP protocol. Always 0. (RFC8866)
            "v=0" + "\n" +
            // Identifies the creator of the SDP document. We are allowed to use dummy values
            // (`-` and `0.0.0.0`) to remain anonymous, which we do. Note that "IN" means
            // "Internet". (RFC8866)
            // TODO: handle IPv6
            "o=- " + (Date.now() / 1000).toFixed() + " 0 IN IP4 " + targetIp + "\n" +
            // Name for the session. We are allowed to pass a dummy `-`. (RFC8866)
            "s=-" + "\n" +
            // Start and end of the validity of the session. `0 0` means that the session never
            // expires. (RFC8866)
            "t=0 0" + "\n" +
            // TODO: remove eventually; this was added just for testing because things didn't seem to work
            "a=group:BUNDLE 0" + "\n" +

            // A lite implementation is only appropriate for devices that will
            // *always* be connected to the public Internet and have a public
            // IP address at which it can receive packets from any
            // correspondent.  ICE will not function when a lite implementation
            // is placed behind a NAT (RFC8445).
            "a=ice-lite" + "\n" +

            // A `m=` line describes a request to establish a certain protocol.
            // The protocol in this line (i.e. `TCP/DTLS/SCTP` or `UDP/DTLS/SCTP`) must always be
            // the same as the one in the offer. We know that this is true because we tweak the
            // offer to match the protocol.
            // The `<fmt>` component must always be `pc-datachannel` for WebRTC.
            // The rest of the SDP payload adds attributes to this specific media stream.
            // RFCs: 8839, 8866, 8841
            "m=application " + targetPort + " " + (protocol == 'tcp' ? "TCP" : "UDP") + "/DTLS/SCTP webrtc-datachannel" + "\n" +
            // Indicates the IP address of the remote.
            // Note that "IN" means "Internet".
            // TODO: handle IPv6
            "c=IN IP4 " + targetIp + "\n" +
            // TODO: remove eventually; goes together with `mid:0`
            "a=mid:0" + "\n" +
            // Indicates that we are complying with RFC8839 (as oppposed to the legacy RFC5245).
            "a=ice-options:ice2" + "\n" +
            // Randomly-generated username and password (the line after). Used only for
            // connectivity checks, which is irrelevant for our situation, but it is mandatory
            // anyway. (RFC8839)
            // The username must have at least 24 bits of entropy, and the password at least 128
            // bits of entropy. (RFC8845)
            "a=ice-ufrag:" + genRandomPayload(24) + "\n" +
            "a=ice-pwd:" + genRandomPayload(128) + "\n" +
            // Fingerprint of the certificate that the server will use during the TLS
            // handshake. (RFC8122)
            // As explained at the top-level documentation, we use a hardcoded certificate.
            // TODO: proper certificate and fingerprint
            "a=fingerprint:sha-256 51:3C:68:8D:CD:62:7C:0B:CC:B7:C9:E2:EB:6C:13:98:9A:C9:82:75:5A:3B:40:BC:4E:42:DE:B5:5A:D0:09:B2" + "\n" +

            // "TLS ID" uniquely identifies a TLS association.
            // The ICE protocol uses a "TLS ID" system to indicate whether a fresh DTLS connection
            // must be reopened in case of ICE renegotiation. Considering that ICE renegotiations
            // never happen in our use case, we can simply put a random value and not care about
            // it. Note however that the TLS ID in the answer must be present if and only if the
            // offer contains one. (RFC8842)
            // TODO: is it true that renegotiations never happen? what about a connection closing?
            // TODO: If the answerer receives an offer that does not contain an SDP "tls-id" attribute, the answerer MUST NOT insert a "tls-id" attribute in the answer.
            // TODO: right now browsers don't send it "a=tls-id:" + genRandomPayload(120) + "\n" +
            // "tls-id" attribute MUST be present in the initial offer and respective answer (RFC8839).
            // "a=tls-id:abc3de65cddef001be82" + "\n" +

            // Indicates that the remote DTLS server will only listen for incoming
            // connections. (RFC5763)
            // The answerer (server) must not be located behind a NAT (RFC6135).
            "a=setup:passive" + "\n" +
            // The SCTP port (RFC8841)
            // Note it's different from the "m=" line port value, which
            // indicates the port of the underlying transport-layer protocol
            // (UDP or TCP)
            "a=sctp-port:5000" + "\n" +
            // The maximum SCTP user message size (in bytes) (RFC8841)
            "a=max-message-size:100000" + "\n" +
            // A transport address for a candidate that can be used for connectivity checks (RFC8839).
            "a=candidate:0 1 " + (protocol == 'tcp' ? "TCP" : "UDP") + " 2113667327 " + targetIp + " " + targetPort + " typ host" + "\n";

        await webrtc.setRemoteDescription({ type: "answer", sdp: remoteSdp });

        console.log(webrtc.remoteDescription!.sdp);
    });

    dataChannel.onopen = () => {
        console.log('open!');
    };

    dataChannel.onerror = (error) => {
        console.log('error! ' + error);
    };
}

/**
 * Generates a random payload whose grammar is: ALPHA / DIGIT / "+" / "/"
 */
function genRandomPayload(entryopyBits: number): string {
    // Note that the grammar is letter, digits, +, and /. In other words, this is base64 except
    // without the potential trailing `=`. This trailing `=` is annoying to handle so we just use
    // hexadecimal.
    let data = new Uint8Array(Math.ceil(entryopyBits / 8));
    window.crypto.getRandomValues(data);
    return [...data].map(x => x.toString(16).padStart(2, '0')).join('');
}
