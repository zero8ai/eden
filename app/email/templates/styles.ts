import type { CSSProperties } from "react";

export const emailStyles = {
  main: {
    backgroundColor: "#f7f7f5",
    color: "#171717",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    margin: 0,
    padding: "32px 12px",
  } satisfies CSSProperties,
  container: {
    backgroundColor: "#ffffff",
    border: "1px solid #e5e5e5",
    borderRadius: "12px",
    margin: "0 auto",
    maxWidth: "560px",
    padding: "36px",
  } satisfies CSSProperties,
  heading: {
    color: "#171717",
    fontSize: "24px",
    fontWeight: 650,
    lineHeight: "32px",
    margin: "0 0 24px",
  } satisfies CSSProperties,
  text: {
    color: "#404040",
    fontSize: "16px",
    lineHeight: "26px",
    margin: "16px 0",
  } satisfies CSSProperties,
  button: {
    backgroundColor: "#171717",
    borderRadius: "7px",
    color: "#ffffff",
    display: "block",
    fontSize: "15px",
    fontWeight: 600,
    margin: "28px 0",
    padding: "13px 20px",
    textAlign: "center",
    textDecoration: "none",
  } satisfies CSSProperties,
  rule: {
    borderColor: "#e5e5e5",
    margin: "28px 0 20px",
  } satisfies CSSProperties,
  footer: {
    color: "#737373",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "8px 0",
  } satisfies CSSProperties,
  link: {
    color: "#525252",
    fontSize: "12px",
    lineHeight: "18px",
    overflowWrap: "anywhere",
    textDecoration: "underline",
  } satisfies CSSProperties,
};
