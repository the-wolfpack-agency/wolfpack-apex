"use client";

import ApexChat from "@/components/ApexChat";

export default function AssistantPage() {
  return (
    <ApexChat
      position="inline"
      height="calc(100vh - 120px)"
      showHistory={true}
      showSource={true}
      showRating={true}
    />
  );
}
