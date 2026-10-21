import { Navbar } from "./components/landing/Navbar";
import { HeroSection } from "./components/landing/HeroSection";
import { PrinciplesSection } from "./components/landing/PrinciplesSection";
import { ClosingSection } from "./components/landing/ClosingSection";
import { Footer } from "./components/landing/Footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-paper text-ink" style={{ fontFamily: "var(--font-ui)" }}>
      <Navbar />
      <main>
        <HeroSection />
        <PrinciplesSection />
        <ClosingSection />
      </main>
      <Footer />
    </div>
  );
}
