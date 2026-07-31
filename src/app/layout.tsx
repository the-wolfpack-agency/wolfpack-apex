import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Wolfpack Instinct",
    template: "%s | Wolfpack Instinct",
  },
  description: "Team intelligence platform for Wolfpack Agency",
  // Icons come from the app/ file convention (favicon.ico, icon.png,
  // apple-icon.png), all generated from public/ogiam-icon.png via
  // `npm run icons:generate`. No hardcoded path so a logo change is one command.
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
