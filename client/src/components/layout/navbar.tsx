import { Link } from "wouter";
import { Activity, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Navbar() {
  return (
    <nav className="fixed top-0 w-full z-50 bg-black/50 backdrop-blur-xl border-b border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center">
              <Activity className="w-5 h-5 text-black" />
            </div>
            <span className="text-white font-display font-bold text-xl tracking-tight">
              Tactician<span className="text-emerald-400">.ai</span>
            </span>
          </div>
          
          <div className="hidden md:flex items-center space-x-8">
            <Link href="/" className="text-sm font-medium text-gray-300 hover:text-white transition-colors">Platform</Link>
            <Link href="/" className="text-sm font-medium text-gray-300 hover:text-white transition-colors">Models</Link>
            <Link href="/" className="text-sm font-medium text-gray-300 hover:text-white transition-colors">Pricing</Link>
            <div className="h-4 w-px bg-white/10"></div>
            <Button variant="ghost" className="text-gray-300 hover:text-white hover:bg-white/5">
              Sign In
            </Button>
            <Button className="bg-emerald-500 hover:bg-emerald-400 text-black font-semibold shadow-[0_0_15px_rgba(16,185,129,0.3)]">
              Get Early Access
            </Button>
          </div>

          <div className="md:hidden">
            <Button variant="ghost" size="icon" className="text-gray-300">
              <Menu className="w-6 h-6" />
            </Button>
          </div>
        </div>
      </div>
    </nav>
  );
}
