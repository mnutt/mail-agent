@0xe61345f4d4dc9e2b;

using Powerbox = import "/sandstorm/powerbox.capnp";

interface ConversationalLlm @0xf51bd5b8fb0c03c5 {
}

interface MailEventPort @0xfae8f6ad1a4d5a18 {
}

interface MailFeed @0xeacb4c5be5bd1e1d {
}

interface MessageSink @0xc3066cb5748fc93b {
}

interface MessageInbox @0xf7ca5184d245daba {
}

interface PushNotification @0xb457c0887886831a {
}

const conversationalLlmDescriptor :Powerbox.PowerboxDescriptor = (
  tags = [
    (id = 0xf51bd5b8fb0c03c5)
  ]
);

const mailEventPortDescriptor :Powerbox.PowerboxDescriptor = (
  tags = [
    (id = 0xfae8f6ad1a4d5a18)
  ]
);

const mailFeedDescriptor :Powerbox.PowerboxDescriptor = (
  tags = [
    (id = 0xeacb4c5be5bd1e1d)
  ]
);

const messageSinkDescriptor :Powerbox.PowerboxDescriptor = (
  tags = [
    (id = 0xc3066cb5748fc93b)
  ]
);

const messageInboxDescriptor :Powerbox.PowerboxDescriptor = (
  tags = [
    (id = 0xf7ca5184d245daba)
  ]
);

const pushNotificationDescriptor :Powerbox.PowerboxDescriptor = (
  tags = [
    (id = 0xb457c0887886831a)
  ]
);
