const gql = require('graphql-tag');

const typeDefs = gql`
enum CallType {
    voice  
    video  
    screen
}

enum CallStatus {
    initiating  
    ringing  
    active  
    ended  
    missed  
    rejected
}

type Call {
    id: ID!
    participantIds: [String!]!
    type: CallType!
    status: CallStatus!
    startTime: DateTime!
}

type STUNConfiguration {
    urls: [String!]!
}

type CallInitiationResponse {
    success: Boolean!
    message: String!
    call: Call
    stunServers: STUNConfiguration
}

type CallSignal {
    callId: ID!
    senderId: String!
    type: String!
    payload: JSON!
}

type CallStateChange {
    callId: ID!
    status: CallStatus!
    timestamp: DateTime!
}

type IncomingCallNotification {
    call: Call!
    caller: User!
}  

  extend type Mutation {
    initiateCall(recipientId: ID!, callType: CallType!): CallInitiationResponse!
    answerCall(callId: ID!): CallInitiationResponse!
    rejectCall(callId: ID!): Boolean!
    endCall(callId: ID!): Boolean!
    sendSDPOffer(callId: ID!, sdp: JSON!): Boolean!
    sendSDPAnswer(callId: ID!, sdp: JSON!): Boolean!
    sendICECandidate(callId: ID!, candidate: JSON!): Boolean!
}  

  extend type Subscription {
    incomingCall: IncomingCallNotification!
    callSignal(callId: ID!): CallSignal!
    callStateChanged(callId: ID!): CallStateChange!
}`;

module.exports = { typeDefs };  