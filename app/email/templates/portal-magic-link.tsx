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

type PortalMagicLinkEmailProps = {
  portalName: string;
  /** Better Auth's tokenised /magic-link/verify URL — one click signs the guest in. */
  url: string;
};

/**
 * One-click sign-in link for a portal guest (issue #180). Clicking is the email verification, so
 * there is no code to type. If a mail scanner pre-consumes the link, the guest can still request a
 * 6-digit code on the portal page — that fallback is why the OTP flow stays.
 */
export default function PortalMagicLinkEmail({
  portalName,
  url,
}: PortalMagicLinkEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{`Your sign-in link for ${portalName}`}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Text style={styles.brand}>
            <span style={styles.brandAccent}>e</span>den
          </Text>
          <Heading style={styles.heading}>You have access to {portalName}</Heading>
          <Text style={styles.text}>
            {portalName} is an AI agent you can chat with in your browser. Click
            below to sign in — no password or code needed.
          </Text>
          <Button href={url} style={styles.button}>
            Open {portalName}
          </Button>
          <Text style={styles.muted}>
            The link expires in 30 minutes and can be used once. If the button
            does not work, request a 6-digit code on the sign-in page instead.
          </Text>
          <Hr style={styles.rule} />
          <Text style={styles.footer}>
            You are receiving this because your email is on the access list of an
            agent portal run on Eden. If you did not expect it, you can ignore
            this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function renderPortalMagicLinkEmail(
  props: PortalMagicLinkEmailProps,
): Promise<string> {
  return render(<PortalMagicLinkEmail {...props} />);
}
