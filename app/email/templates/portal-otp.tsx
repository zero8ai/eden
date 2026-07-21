import {
  Body,
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

type PortalOtpEmailProps = {
  portalName: string;
  otp: string;
};

/** Six-digit sign-in code for a portal guest (issue #180) — OTP over magic links because
 * corporate mail scanners eat links. */
export default function PortalOtpEmail({ portalName, otp }: PortalOtpEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{`${otp} is your ${portalName} sign-in code`}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Text style={styles.brand}>
            <span style={styles.brandAccent}>e</span>den
          </Text>
          <Heading style={styles.heading}>Your sign-in code</Heading>
          <Text style={styles.text}>
            Enter this code to sign in to {portalName}:
          </Text>
          <Text
            style={{
              ...styles.heading,
              fontSize: "32px",
              letterSpacing: "8px",
              fontFamily: "monospace",
            }}
          >
            {otp}
          </Text>
          <Text style={styles.muted}>
            The code expires in 10 minutes. If you did not request it, you can
            ignore this email.
          </Text>
          <Hr style={styles.rule} />
          <Text style={styles.footer}>
            You are receiving this because your email is on the access list of
            an agent portal run on Eden.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function renderPortalOtpEmail(
  props: PortalOtpEmailProps,
): Promise<string> {
  return render(<PortalOtpEmail {...props} />);
}
