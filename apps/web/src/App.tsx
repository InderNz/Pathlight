import { ConfigPage } from "./features/config/ConfigPage";
import { FishbonePage } from "./features/fishbone/FishbonePage";
import { HistoryPage } from "./features/history/HistoryPage";
import { MappingReviewPage } from "./features/mapping/MappingReviewPage";
import { RiskPage } from "./features/risk/RiskPage";
import { TestGenerationPage } from "./features/testgeneration/TestGenerationPage";

export function App() {
  const path = window.location.pathname;
  if (path === "/config") return <ConfigPage />;
  if (path === "/mapping-review") return <MappingReviewPage />;
  if (path === "/test-generation") return <TestGenerationPage />;
  if (path === "/risk") return <RiskPage />;
  if (path === "/history") return <HistoryPage />;
  return <FishbonePage />;
}
