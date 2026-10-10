//! Fetching many byte ranges of one object with few requests: ranges close
//! to each other are covered by one request (reading a little more than
//! asked costs less than another round trip), up to a size cap.

use std::ops::Range;

use bytes::Bytes;

/// The requests that cover a set of ranges, and where each range sits in them.
pub struct Plan {
    requests: Vec<Range<u64>>,
    /// per original range: (request index, start and end inside the request)
    places: Vec<Option<(usize, Range<usize>)>>,
}

impl Plan {
    /// Ranges at most `gap` bytes apart share a request while it stays under
    /// `max` bytes (a range larger than that is a request of its own).
    /// Empty ranges need no request.
    pub fn new(ranges: &[Range<u64>], gap: u64, max: u64) -> Plan {
        let mut order: Vec<usize> = (0..ranges.len()).filter(|&i| ranges[i].start < ranges[i].end).collect();
        order.sort_by_key(|&i| (ranges[i].start, std::cmp::Reverse(ranges[i].end)));
        let mut requests: Vec<Range<u64>> = vec![];
        let mut places = vec![None; ranges.len()];
        for i in order {
            let r = &ranges[i];
            let joins = requests.last().is_some_and(|cur| {
                r.start <= cur.end.saturating_add(gap) && r.end.max(cur.end) - cur.start <= max.max(cur.end - cur.start)
            });
            if joins {
                let cur = requests.last_mut().expect("joined a request");
                cur.end = cur.end.max(r.end);
            } else {
                requests.push(r.clone());
            }
            let at = requests.len() - 1;
            places[i] = Some((at, (r.start - requests[at].start) as usize..(r.end - requests[at].start) as usize));
        }
        Plan { requests, places }
    }

    pub fn requests(&self) -> &[Range<u64>] {
        &self.requests
    }

    /// The original ranges' bytes out of the fetched requests (in request order).
    /// A store that returned less than asked yields shorter slices.
    pub fn slice(&self, fetched: &[Bytes]) -> Vec<Bytes> {
        self.places
            .iter()
            .map(|p| match p {
                None => Bytes::new(),
                Some((at, r)) => {
                    let data = &fetched[*at];
                    data.slice(r.start.min(data.len())..r.end.min(data.len()))
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reqs(ranges: &[Range<u64>], gap: u64, max: u64) -> Vec<Range<u64>> {
        Plan::new(ranges, gap, max).requests().to_vec()
    }

    #[test]
    fn nearby_ranges_share_a_request() {
        let r = [100..200, 0..50, 60..90, 5000..5100];
        assert_eq!(reqs(&r, 10, u64::MAX), vec![0..200, 5000..5100]);
        assert_eq!(reqs(&r, 0, u64::MAX), vec![0..50, 60..90, 100..200, 5000..5100]);
        assert_eq!(reqs(&r, 10_000, u64::MAX), vec![0..5100]);
        assert!(reqs(&[], 10, 10).is_empty());
    }

    #[test]
    fn requests_are_capped_but_a_big_range_stays_whole() {
        assert_eq!(reqs(&[0..40, 40..80, 80..120], 0, 100), vec![0..80, 80..120]);
        assert_eq!(reqs(&[0..300, 300..310], 0, 100), vec![0..300, 300..310]);
        // nested ranges add nothing, so they never split a request
        assert_eq!(reqs(&[0..300, 10..20], 0, 100), vec![0..300]);
    }

    #[test]
    fn slices_come_back_in_the_callers_order() {
        let file: Vec<u8> = (0..=255).collect();
        let ranges = [100..110, 0..4, 8..12, 7..7, 104..106];
        let plan = Plan::new(&ranges, 8, u64::MAX);
        let fetched: Vec<Bytes> = plan.requests().iter().map(|r| Bytes::copy_from_slice(&file[r.start as usize..r.end as usize])).collect();
        let got = plan.slice(&fetched);
        assert_eq!(plan.requests(), &[0..12, 100..110]);
        assert_eq!(&got[0][..], &file[100..110]);
        assert_eq!(&got[1][..], &file[0..4]);
        assert_eq!(&got[2][..], &file[8..12]);
        assert!(got[3].is_empty());
        assert_eq!(&got[4][..], &file[104..106]);
    }

    #[test]
    fn short_responses_do_not_panic() {
        let plan = Plan::new(&[0..10, 20..30], 100, u64::MAX);
        let got = plan.slice(&[Bytes::from_static(b"0123456789abcdef")]);
        assert_eq!(&got[0][..], b"0123456789");
        assert_eq!(&got[1][..], b"");
    }
}
