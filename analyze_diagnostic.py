#!/usr/bin/env python3
"""Analyze Hush Tab diagnostic data to identify ad detection signals."""

import json
import sys

def analyze_diagnostic(filepath):
    with open(filepath, 'r') as f:
        data = json.load(f)
    
    markers = data['analysis']['userMarkers']
    player_states = data['playerState']
    network_requests = data['networkRequests']
    
    print("=" * 80)
    print("HUSH TAB DIAGNOSTIC ANALYSIS - NBC")
    print("=" * 80)
    
    # Show user markers
    print("\n📍 USER MARKERS (Manual Ad Annotations):")
    print("-" * 80)
    for marker in markers:
        ts = marker['timestamp']
        event = marker['event']
        print(f"  {ts:7d}ms - {event}")
    
    # Analyze each ad period
    print("\n" + "=" * 80)
    print("🎯 AD PERIOD ANALYSIS")
    print("=" * 80)
    
    # Group markers into ad periods
    ad_periods = []
    for i in range(0, len(markers), 2):
        if i + 1 < len(markers):
            ad_periods.append({
                'start': markers[i]['timestamp'],
                'end': markers[i+1]['timestamp'],
                'duration': markers[i+1]['timestamp'] - markers[i]['timestamp']
            })
    
    for idx, period in enumerate(ad_periods, 1):
        print(f"\n--- AD PERIOD {idx} ---")
        print(f"Start: {period['start']}ms")
        print(f"End:   {period['end']}ms")
        print(f"Duration: {period['duration']/1000:.1f}s")
        
        # Find player states during this period
        print("\n  Player States During Ad:")
        states_in_period = [
            s for s in player_states 
            if period['start'] <= s['timestamp'] <= period['end']
        ]
        
        if states_in_period:
            # Sample a few states
            samples = states_in_period[::max(1, len(states_in_period)//5)]
            for state in samples[:5]:
                duration = state.get('duration', 'N/A')
                current_time = state.get('currentTime', 0)
                
                print(f"    t={state['timestamp']}ms: duration={duration}, currentTime={current_time:.2f}s")
                
                # Check for interesting NBC player data
                if 'nbcPlayer' in state and state['nbcPlayer']:
                    nbc = state['nbcPlayer']
                    print(f"      → isShortVideo: {nbc.get('isShortVideo')}")
                    print(f"      → adOverlay: {nbc.get('adOverlay')}")
                    print(f"      → adTextFound: {nbc.get('adTextFound')}")
                    print(f"      → seekDisabled: {nbc.get('seekDisabled')}")
        
        # Find network activity during this period
        print("\n  Network Requests During Ad:")
        ad_networks = {}
        requests_in_period = [
            r for r in network_requests
            if period['start'] <= r['timestamp'] <= period['end']
        ]
        
        for req in requests_in_period:
            if req.get('isAdRelated'):
                # Extract domain
                url = req['url']
                if 'mediatailor' in url:
                    domain = 'mediatailor.amazonaws.com'
                elif 'omtrdc.net' in url:
                    domain = 'nbcume.hb.omtrdc.net'
                else:
                    domain = url.split('/')[2] if len(url.split('/')) > 2 else url
                
                ad_networks[domain] = ad_networks.get(domain, 0) + 1
        
        for domain, count in sorted(ad_networks.items(), key=lambda x: x[1], reverse=True)[:5]:
            print(f"    {count:3d}x {domain}")
    
    # Look for patterns
    print("\n" + "=" * 80)
    print("🔍 PATTERN ANALYSIS")
    print("=" * 80)
    
    # Check if duration changes
    print("\nVideo Duration Pattern:")
    durations_seen = set()
    for state in player_states[:20]:  # Check first 20 states
        duration = state.get('duration')
        if duration and duration != float('inf'):
            durations_seen.add(duration)
    
    print(f"  Unique durations seen: {durations_seen}")
    
    # Check for short video durations during ads
    print("\nShort Video Detection During Ads:")
    for idx, period in enumerate(ad_periods, 1):
        states_in_ad = [s for s in player_states if period['start'] <= s['timestamp'] <= period['end']]
        short_videos = [s for s in states_in_ad if s.get('duration', float('inf')) < 120]
        
        if short_videos:
            print(f"  Ad Period {idx}: Found {len(short_videos)} states with duration < 120s")
            if short_videos:
                sample = short_videos[0]
                print(f"    Example: duration={sample.get('duration')}s at t={sample['timestamp']}ms")
        else:
            print(f"  Ad Period {idx}: No short video durations detected")
    
    print("\n" + "=" * 80)

if __name__ == '__main__':
    if len(sys.argv) > 1:
        analyze_diagnostic(sys.argv[1])
    else:
        analyze_diagnostic('diagnostic/hush-tab-diagnostic-nbc-1770172112291.json')
