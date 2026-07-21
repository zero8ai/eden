import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  render,
  Text,
} from "@react-email/components";

import { emailStyles as styles } from "./styles";

type PortalInviteEmailProps = {
  portalName: string;
  portalUrl: string;
  inviterName: string;
};

/** Access-list notification for a portal guest (issue #180): the link to the chat page. Entry
 * itself is authenticated by the OTP flow on that page, so this link carries no token. */
export default function PortalInviteEmail({
  portalName,
  portalUrl,
  inviterName,
}: PortalInviteEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{`${inviterName} gave you access to ${portalName}`}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Text style={styles.brand}>
            <span style={styles.brandAccent}>e</span>den
          </Text>
          <Heading style={styles.heading}>You have access to {portalName}</Heading>
          <Text style={styles.text}>
            {inviterName} added you to the access list of {portalName}, an AI
            agent you can chat with in your browser. Open the link and sign in
            with this email address — you&apos;ll receive a one-time code, no
            password or account setup needed.
          </Text>
          <Button href={portalUrl} style={styles.button}>
            Open {portalName}
          </Button>
          <Hr style={styles.rule} />
          <Text style={styles.footer}>
            If the button does not work, copy and paste this URL into your
            browser:
          </Text>
          <Text style={styles.link}>{portalUrl}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function renderPortalInviteEmail(
  props: PortalInviteEmailProps,
): Promise<string> {
  return render(<PortalInviteEmail {...props} />);
}
