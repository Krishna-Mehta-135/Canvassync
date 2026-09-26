import { Navbar } from "./components/landing/Navbar";
import { HeroSection } from "./components/landing/HeroSection";
import { InteractiveDemoSection } from "./components/landing/InteractiveDemoSection";
import { FeaturesSection } from "./components/landing/FeaturesSection";
import { TeamFeaturesSection } from "./components/landing/TeamFeaturesSection";
import { ToolbarShowcase } from "./components/landing/ToolbarShowcase";
import { AIHighlightSection } from "./components/landing/AIHighlightSection";
import { HowItWorksSection } from "./components/landing/HowItWorksSection";
import { FinalCTASection } from "./components/landing/FinalCTASection";
import { Footer } from "./components/landing/Footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_20%_15%,rgba(59,130,246,0.22),transparent_40%),radial-gradient(circle_at_80%_12%,rgba(16,185,129,0.18),transparent_35%),radial-gradient(circle_at_50%_50%,rgba(99,102,241,0.12),transparent_60%),linear-gradient(180deg,#edf4ff_0%,#ffffff_45%,#f0f7ff_100%)] text-gray-900 transition-colors duration-300 dark:bg-[radial-gradient(circle_at_18%_12%,rgba(59,130,246,0.20),transparent_30%),radial-gradient(circle_at_82%_10%,rgba(139,92,246,0.16),transparent_24%),linear-gradient(180deg,#0f172a_0%,#020617_70%,#020617_100%)] dark:text-white">
      <Navbar />
      <HeroSection />
      <InteractiveDemoSection />
      <AIHighlightSection />
      <FeaturesSection />
      <TeamFeaturesSection />
      <ToolbarShowcase />
      <HowItWorksSection />
      <FinalCTASection />
      <Footer />
    </div>
  );
}
