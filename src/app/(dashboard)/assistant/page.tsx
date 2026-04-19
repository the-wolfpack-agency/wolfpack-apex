"use client";

import InstinctChat from "@/components/InstinctChat";

export default function AssistantPage() {
  return (
    <InstinctChat
      position="inline"
      height="calc(100vh - 120px)"
      showHistory={true}
      showSource={true}
      showRating={true}
    />
  );
}
