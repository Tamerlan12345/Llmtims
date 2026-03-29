import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CentrasDEVTEAM | Tactical Office",
  description: "Пиксельный офис для автономной AI-команды",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
